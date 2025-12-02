package com.agui.client.jsonpatch.lcs


/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * Default [Equator] implementation.
 *
 * @param <T>  the types of object this [Equator] can evaluate.
 * @since 4.0
 * @version $Id: DefaultEquator.java 1543950 2013-11-20 21:13:35Z tn $
</T> */
class DefaultEquator<T>
/**
 * Restricted constructor.
 */
private constructor() : Equator<T> {
    /**
     * {@inheritDoc} Delegates to [Object.equals].
     */
    override fun equate(o1: T, o2: T): Boolean {
        return o1 === o2 || o1 != null && o1 == o2
    }

    /**
     * {@inheritDoc}
     *
     * @return `o.hashCode()` if `o` is non-
     * `null`, else [.HASHCODE_NULL].
     */
    override fun hash(o: T): Int {
        return o?.hashCode() ?: HASHCODE_NULL
    }

    private fun readResolve(): Any {
        return INSTANCE
    }

    companion object {
        /** Serial version UID  */
        private const val serialVersionUID = 825802648423525485L

        /** Static instance  */
        // the static instance works for all types
        val INSTANCE: DefaultEquator<*> = DefaultEquator<Any>()

        /**
         * Hashcode used for `null` objects.
         */
        const val HASHCODE_NULL = -1

        /**
         * Factory returning the typed singleton instance.
         *
         * @param <T>  the object type
         * @return the singleton instance
        </T> */
        // the static instance works for all types
        fun <T> defaultEquator(): DefaultEquator<T> {
            return INSTANCE as DefaultEquator<T>
        }
    }
}
